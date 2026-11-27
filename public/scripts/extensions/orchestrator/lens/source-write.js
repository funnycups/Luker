// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Luker-side writes and model access for Orchestra Lens.
//
// Saving agent fields: re-read the stored profile for the same target
// (mode + scope + preset id), put only the changed fields on top (so the
// rest, including edits made elsewhere meanwhile, survives) and
// write it the way the orchestrator's own editor does. Afterwards the
// editor's cached drafts are reloaded (editor-state.js initializeUiState),
// otherwise a later save would overwrite ours.

import { i18n, i18nFormat } from './i18n.js';
import { getConnectionProfileNames, getOpenAIPresetNames } from '../../../lens-shared/preset-selectors.js';
import {
    DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT,
    DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE,
    defaultSpec,
    sanitizeDirectorProfile,
} from '../defaults.js';
import { sanitizeAgendaWorkingProfile } from '../agenda-profile.js';
import { toEditablePresetMap, toEditableSpec } from '../editable-spec.js';
import {
    loadGlobalAgendaEditorState,
    loadGlobalDirectorEditorState,
    loadGlobalEditorState,
    loadGlobalLoopEditorState,
    refreshUiStateFromHost,
} from '../editor-state.js';
import {
    createPreset,
    deletePreset,
    duplicatePreset,
    getActivePreset,
    getActivePresetId,
    getPreset,
    listPresets,
    renamePreset,
    sanitizePresetEntry,
    setActivePresetId,
    writeActivePreset,
} from '../preset-library.js';
import {
    applyCharacterExecutionModeForAvatar,
    clearCharacterExtensionForMode,
    getCharacterActivePresetId,
    getCharacterExtensionDataByAvatar,
    getCharacterIndexByAvatar,
    getCharacterPresetLibrary,
} from '../character-overrides.js';
import {
    persistCharacterAgendaEditor,
    persistCharacterDirectorEditor,
    persistCharacterEditor,
    persistCharacterLoopEditor,
    persistCustomToolsKeepingDrafts,
    persistGlobalPresetWrite,
    persistOrchestratorCharacterExtension,
    persistRuntimeLimitsKeepingDrafts,
} from '../editor-persist.js';
import {
    captureCharacterOrchestratorMutation,
    captureGlobalPresetMutation,
    persistGlobalLibraryWithLifecycle,
    restoreCharacterOrchestratorState,
    restoreGlobalPresetState,
    saveSettingsCheckedThroughContext,
    snapshotCharacterOrchestratorState,
    snapshotGlobalPresetState,
} from '../preset-persistence.js';
import {
    copyOrchPresetSkills,
    emitOrchPresetDeleted,
    emitOrchPresetExportReady,
    emitOrchPresetImportReady,
    renameOrchPresetSkills,
} from '../preset-lifecycle-hooks.js';
import {
    buildPortablePayloadForMode,
    copyAgendaAgentsIntoSpecEditor,
    copySpecPresetsIntoAgendaEditor,
    extractImportedProfileForMode,
    parseImportedProfilePayload,
} from '../preset-io.js';
import { sanitizeAgentToolFlags, sanitizeLoopProfile } from '../persistence.js';
import { sanitizeConnectionProfileName } from '../agent-resolution.js';
import { normalizeCapsuleInjectPosition } from '../capsule-injection.js';
import { buildDirectorDefaultSystemPrompt } from '../director-default-prompt.js';
import { promptEmbedUnembeddedPresetsForCharacterApply } from '../prompt-embed-unembedded.js';
import { getField, mergeChanges, validateStructure } from './model/edit.js';

export class WriteError extends Error {
    constructor(code, message) {
        super(message || code);
        this.code = code;
    }
}

const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

export async function persistHostSettings(ctx) {
    if (typeof ctx?.workbench?.saveSettingsChecked === 'function' || typeof ctx?.saveSettings === 'function') {
        await saveSettingsViaContext(ctx);
        return;
    }
    ctx?.saveSettingsDebounced?.();
}

async function saveSettingsViaContext(ctx) {
    try {
        await saveSettingsCheckedThroughContext(ctx);
    } catch (err) {
        if (err instanceof WriteError) throw err;
        throw new WriteError('write', i18n('Failed to save the settings'));
    }
}

/** The stored profile for a target, in the same shape the lens reads. */
function readTarget(ctx, settings, target) {
    const { mode, scope, presetId } = target;
    if (mode === 'single') {
        return {
            spec: { stages: [{ id: 'single', mode: 'serial', nodes: ['single_agent'] }] },
            presets: {
                single_agent: {
                    systemPrompt: String(settings.singleAgentSystemPrompt ?? ''),
                    userPromptTemplate: String(settings.singleAgentUserPromptTemplate ?? ''),
                },
            },
        };
    }
    if (scope === 'chat') {
        const agenda = settings.chatOverrides?.[target.chatKey]?.agenda;
        if (!agenda?.enabled) throw new WriteError('target-gone', i18n('The dispatch profile dedicated to this chat has been turned off'));
        return clone(agenda);
    }
    if (scope === 'factory' || !presetId) throw new WriteError('no-preset', i18n('The profile to edit was deleted'));
    const entry = getPreset(settings, mode, scope, presetId, { context: ctx, avatar: target.avatar });
    if (!entry) throw new WriteError('target-gone', i18n('The profile to edit was deleted or renamed'));
    return clone(entry);
}

const fieldWriteEpochs = new WeakMap();
let nextFieldWriteEpoch = 0;

function bumpFieldEpoch(holder, key) {
    let map = fieldWriteEpochs.get(holder);
    if (!map) {
        map = new Map();
        fieldWriteEpochs.set(holder, map);
    }
    const epoch = ++nextFieldWriteEpoch;
    map.set(key, epoch);
    return epoch;
}

async function saveFields(ctx, holder, fields) {
    const previous = new Map(Object.keys(fields).map(key => [key, {
        descriptor: Object.getOwnPropertyDescriptor(holder, key),
        epoch: bumpFieldEpoch(holder, key),
    }]));
    Object.assign(holder, fields);
    try {
        await saveSettingsViaContext(ctx);
    } catch (error) {
        const epochs = fieldWriteEpochs.get(holder);
        for (const [key, { descriptor, epoch }] of previous) {
            if (epochs?.get(key) !== epoch || holder[key] !== fields[key]) continue;
            if (descriptor) Object.defineProperty(holder, key, descriptor);
            else delete holder[key];
        }
        throw error;
    }
}

async function writeTarget(ctx, settings, target, profile) {
    const { mode, scope, presetId } = target;
    if (mode === 'single') {
        const single = profile?.presets?.single_agent || {};
        await saveFields(ctx, settings, { singleAgentSystemPrompt: String(single.systemPrompt || ''), singleAgentUserPromptTemplate: String(single.userPromptTemplate || '') });
        return;
    }
    if (scope === 'chat') {
        await saveFields(ctx, settings.chatOverrides[target.chatKey], { agenda: { ...profile, enabled: true } });
        return;
    }
    if (scope === 'global') {
        const library = settings.presetLibraries?.[mode];
        if (!library?.[presetId]) throw new WriteError('target-gone', i18n('The profile to edit was deleted'));
        if (presetId === getActivePresetId(settings, mode, { scope: 'global' })) {
            const ok = await persistGlobalPresetWrite(
                settings,
                mode,
                () => writeActivePreset(settings, mode, 'global', profile, { context: ctx }),
                {
                    context: ctx,
                    replaceGlobal: true,
                },
            );
            if (!ok) throw new WriteError('write', i18n('Failed to save the settings'));
            return;
        }
        await saveFields(ctx, library, { [presetId]: sanitizePresetEntry(mode, { ...profile, name: library[presetId].name }) });
        return;
    }
    const index = (ctx.characters || []).findIndex(c => String(c?.avatar || '') === String(target.avatar || ''));
    if (index < 0) throw new WriteError('target-gone', i18n('The profile on the character card was deleted'));
    let targetGone = false;
    const ok = await ctx.getExtensionApi('orchestrator').persistOrchestratorCharacterExtension(ctx, index, (current) => {
        const ext = current && typeof current === 'object' ? clone(current) : null;
        const library = ext?.presetLibraries?.[mode];
        if (!library?.[presetId]) {
            targetGone = true;
            throw new WriteError('target-gone', i18n('The profile on the character card was deleted'));
        }
        library[presetId] = sanitizePresetEntry(mode, { ...profile, name: library[presetId].name });
        return ext;
    });
    if (targetGone) throw new WriteError('target-gone', i18n('The profile on the character card was deleted'));
    if (!ok) throw new WriteError('write', i18n('Failed to write to the character card'));
}

/** Syncs shared editor state from host without discarding unrelated unsaved drafts. */
function refreshEditors(ctx) {
    refreshUiStateFromHost(ctx);
}

/**
 * @param {() => { ctx: object, settings: object }} host
 */
export function createProfileAccess(host) {
    return {
        /**
         * @param {object} target  snapshot.target { mode, scope, presetId, avatar, chatKey }
         * @param {object[]} changes  [{agentId, field, before, after}]
         * @param {{ force?: boolean }} opts  write even if some fields changed elsewhere
         * @returns {Promise<{ saved: boolean, conflicts: object[], missing: object[] }>}
         */
        async save(target, changes, { force = false, requireAll = false } = {}) {
            const { ctx, settings } = host();
            const fresh = readTarget(ctx, settings, target);
            const { profile, conflicts, missing } = mergeChanges(target.mode, fresh, changes);
            if ((conflicts.length && !force) || (requireAll && missing.length)) return { saved: false, conflicts, missing };
            const problems = validateStructure(target.mode, profile);
            if (problems.length) throw new WriteError('invalid', problems.join('\n'));
            const applied = changes.filter(change => !missing.includes(change)).map(change => ({
                ...change, before: getField(target.mode, fresh, change.agentId, change.field),
            })).filter(change => change.before !== change.after);
            await writeTarget(ctx, settings, target, profile);
            refreshEditors(ctx);
            return { saved: true, conflicts, missing, applied };
        },

        /** Connection profiles and generation presets to pick from. */
        async options() {
            const { ctx } = host();
            return {
                connections: getConnectionProfileNames(ctx.connectionProfiles.list()),
                presets: getOpenAIPresetNames(ctx),
            };
        },

        /** Every tool flag on or off. Director keeps `finalize` off in its defaults. */
        allTools(mode, enabled) {
            const flags = sanitizeAgentToolFlags({}, { defaultAllOn: enabled, forceFinalize: false });
            if (mode === 'director') flags.finalize = false;
            return flags;
        },
        baseTools: () => sanitizeAgentToolFlags({}),
        defaultMainPrompt: (subAgents) => buildDirectorDefaultSystemPrompt({ subAgents }),

        /** The other mode's active preset converted for a spec <-> agenda copy, or null. */
        convertFrom(target, profile) {
            const { ctx, settings } = host();
            const scope = target.scope === 'character' ? 'character' : 'global';
            const from = target.mode === 'agenda' ? 'spec' : 'agenda';
            const source = getActivePreset(settings, from, { scope, context: ctx, avatar: target.avatar }).state;
            if (!source) return null;
            const next = clone(profile);
            if (target.mode === 'agenda') {
                copySpecPresetsIntoAgendaEditor(clone(source), next);
            } else {
                copyAgendaAgentsIntoSpecEditor(clone(source), next);
            }
            return next;
        },
    };
}

const scopeOf = (target) => (target?.scope === 'character' ? 'character' : 'global');

async function persistCharacterLibraryInPlace(ctx, avatar) {
    const index = getCharacterIndexByAvatar(ctx, avatar);
    if (index < 0) throw new WriteError('no-character', i18n('No character selected.'));
    const prev = getCharacterExtensionDataByAvatar(ctx, avatar);
    if (!prev || typeof prev !== 'object' || Object.keys(prev).length === 0) return true;
    return persistOrchestratorCharacterExtension(ctx, index, { ...prev });
}

function toCharacterEditorFromProfile(mode, profile) {
    if (mode === 'loop') return sanitizeLoopProfile(profile);
    if (mode === 'agenda') return sanitizeAgendaWorkingProfile(profile);
    if (mode === 'director') return sanitizeDirectorProfile(profile);
    const presets = toEditablePresetMap(profile?.presets);
    const spec = toEditableSpec(profile?.spec || defaultSpec, presets);
    return { spec, presets };
}

function downloadJson(fileName, payload) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Preset library actions, mirroring the orchestrator's own selector bar. */
export function createPresetAccess(host) {
    const refreshed = (ctx) => refreshEditors(ctx);
    const opts = (ctx, avatar) => ({ context: ctx, avatar });
    const desiredChangeListeners = new Set();
    const notifyDesiredChange = async () => {
        for (const fn of [...desiredChangeListeners]) {
            await fn();
        }
    };
    const nameOf = (ctx, settings, mode, scope, avatar, id) => {
        const library = scope === 'character' ? getCharacterPresetLibrary(ctx, avatar, mode) : (settings.presetLibraries?.[mode] || {});
        return String(library?.[id]?.name || '').trim();
    };
    const notifyDesiredChangeSafe = async () => {
        try {
            await notifyDesiredChange();
        } catch (err) {
            console.error('[orchestrator] UI resync listener threw during rollback:', err);
        }
    };
    const persistCharacterWithRollback = async (ctx, avatar, snap, { notify = true } = {}) => {
        let saved = false;
        try {
            saved = await persistCharacterLibraryInPlace(ctx, avatar);
        } catch (err) {
            restoreCharacterOrchestratorState(ctx, snap);
            if (notify) {
                refreshed(ctx);
                await notifyDesiredChangeSafe();
            }
            throw err;
        }
        if (!saved) {
            restoreCharacterOrchestratorState(ctx, snap);
            if (notify) {
                refreshed(ctx);
                await notifyDesiredChangeSafe();
            }
            return false;
        }
        return true;
    };
    const lifecycleHooks = { copyOrchPresetSkills, emitOrchPresetDeleted, renameOrchPresetSkills };
    const persistGlobalWithRollback = async (ctx, settings, mode, snap, persistOpts = undefined, onRollback = null) => {
        let ok = false;
        try {
            ok = await persistGlobalLibraryWithLifecycle(ctx, settings, mode, { ...persistOpts, lifecycleHooks });
        } catch (err) {
            restoreGlobalPresetState(settings, snap);
            onRollback?.();
            refreshed(ctx);
            await notifyDesiredChangeSafe();
            throw err;
        }
        if (!ok) {
            restoreGlobalPresetState(settings, snap);
            onRollback?.();
            refreshed(ctx);
            await notifyDesiredChangeSafe();
            return false;
        }
        return true;
    };
    const notifyOrRollback = async (ctx, settings, globalSnap, charSnap) => {
        try {
            await notifyDesiredChange();
        } catch (err) {
            restoreGlobalPresetState(settings, globalSnap);
            restoreCharacterOrchestratorState(ctx, charSnap);
            refreshed(ctx);
            throw err;
        }
    };
    return {
        onDesiredChange(fn) {
            if (typeof fn === 'function') {
                desiredChangeListeners.add(fn);
                return () => { desiredChangeListeners.delete(fn); };
            }
            desiredChangeListeners.clear();
            return () => {};
        },

        list(target) {
            const { ctx, settings } = host();
            const { mode, avatar } = target;
            const library = avatar ? getCharacterPresetLibrary(ctx, avatar, mode) || {} : {};
            return {
                global: listPresets(settings, mode, { scope: 'global', context: ctx }),
                character: Object.keys(library).map(id => ({ id, name: String(library[id]?.name || '') })),
            };
        },

        /** Picking a global preset also clears the card's own active slot. */
        async select(target, scope, presetId) {
            const { ctx, settings } = host();
            const { mode, avatar } = target;
            if (!getPreset(settings, mode, scope, presetId, opts(ctx, avatar))) {
                throw new WriteError('target-gone', i18n('Preset no longer exists — refreshing the list.'));
            }
            const hadCardSlot = Boolean(avatar) && Boolean(getCharacterActivePresetId(ctx, avatar, mode));
            const charSnap = (scope === 'character' || hadCardSlot) ? snapshotCharacterOrchestratorState(ctx, avatar) : null;
            const globalSnap = scope === 'global' ? snapshotGlobalPresetState(settings, mode) : null;
            if (scope === 'global' && hadCardSlot) {
                setActivePresetId(settings, mode, 'character', '', opts(ctx, avatar));
            }
            if (!setActivePresetId(settings, mode, scope, presetId, opts(ctx, avatar))) {
                restoreCharacterOrchestratorState(ctx, charSnap);
                restoreGlobalPresetState(settings, globalSnap);
                throw new WriteError('target-gone', i18n('Preset no longer exists — refreshing the list.'));
            }
            captureGlobalPresetMutation(globalSnap, settings);
            captureCharacterOrchestratorMutation(charSnap, ctx);
            refreshed(ctx);
            await notifyOrRollback(ctx, settings, globalSnap, charSnap);
            if (scope === 'global') {
                const ok = await persistGlobalWithRollback(
                    ctx,
                    settings,
                    mode,
                    globalSnap,
                    { directSave: hadCardSlot },
                    charSnap ? () => restoreCharacterOrchestratorState(ctx, charSnap) : null,
                );
                if (!ok) {
                    throw new WriteError('write', i18n('Failed to save the settings'));
                }
                if (hadCardSlot) {
                    let cardSaved = false;
                    let cardErr = null;
                    try {
                        cardSaved = await persistCharacterWithRollback(ctx, avatar, charSnap, { notify: false });
                    } catch (err) {
                        cardErr = err;
                    }
                    if (!cardSaved) {
                        let rollbackFailed = false;
                        let rollbackErr = null;
                        if (restoreGlobalPresetState(settings, globalSnap)) {
                            try {
                                const reverted = await persistGlobalLibraryWithLifecycle(ctx, settings, mode, { directSave: true });
                                if (!reverted) rollbackFailed = true;
                            } catch (err) {
                                rollbackFailed = true;
                                rollbackErr = err;
                                console.error('[orchestrator] Failed to revert global preset after character save failure:', err);
                            }
                        }
                        refreshed(ctx);
                        await notifyDesiredChangeSafe();
                        if (rollbackFailed) {
                            const detail = rollbackErr?.message || cardErr?.message || i18n('Failed to save the settings');
                            throw new WriteError('write', `${i18n('Failed to persist character override.')} (${detail})`);
                        }
                        if (cardErr) throw cardErr;
                        throw new WriteError('write', i18n('Failed to save the settings'));
                    }
                }
                return;
            }
            if (avatar) {
                const cardSaved = await persistCharacterWithRollback(ctx, avatar, charSnap);
                if (!cardSaved) throw new WriteError('write', i18n('Failed to persist character override.'));
            }
        },

        async create(target, name) {
            const { ctx, settings } = host();
            const scope = scopeOf(target);
            const charSnap = scope === 'character' ? snapshotCharacterOrchestratorState(ctx, target.avatar) : null;
            const globalSnap = scope === 'global' ? snapshotGlobalPresetState(settings, target.mode) : null;
            const id = createPreset(settings, target.mode, scope, { name }, opts(ctx, target.avatar));
            if (!id || !setActivePresetId(settings, target.mode, scope, id, opts(ctx, target.avatar))) {
                restoreCharacterOrchestratorState(ctx, charSnap);
                restoreGlobalPresetState(settings, globalSnap);
                throw new WriteError('write', i18n('Could not save the preset.'));
            }
            captureGlobalPresetMutation(globalSnap, settings);
            captureCharacterOrchestratorMutation(charSnap, ctx);
            refreshed(ctx);
            await notifyOrRollback(ctx, settings, globalSnap, charSnap);
            if (scope === 'character') {
                if (!await persistCharacterWithRollback(ctx, target.avatar, charSnap)) {
                    throw new WriteError('write', i18n('Failed to persist character override.'));
                }
                return;
            }
            if (!await persistGlobalWithRollback(ctx, settings, target.mode, globalSnap)) {
                throw new WriteError('write', i18n('Failed to save the settings'));
            }
        },

        async duplicate(target, name) {
            const { ctx, settings } = host();
            const scope = scopeOf(target);
            const oldName = nameOf(ctx, settings, target.mode, scope, target.avatar, target.presetId);
            const charSnap = scope === 'character' ? snapshotCharacterOrchestratorState(ctx, target.avatar) : null;
            const globalSnap = scope === 'global' ? snapshotGlobalPresetState(settings, target.mode) : null;
            const id = duplicatePreset(settings, target.mode, scope, target.presetId, { name }, opts(ctx, target.avatar));
            if (!id || !setActivePresetId(settings, target.mode, scope, id, opts(ctx, target.avatar))) {
                restoreCharacterOrchestratorState(ctx, charSnap);
                restoreGlobalPresetState(settings, globalSnap);
                throw new WriteError('write', i18n('Could not save the preset.'));
            }
            captureGlobalPresetMutation(globalSnap, settings);
            captureCharacterOrchestratorMutation(charSnap, ctx);
            refreshed(ctx);
            await notifyOrRollback(ctx, settings, globalSnap, charSnap);
            if (scope === 'character') {
                if (!await persistCharacterWithRollback(ctx, target.avatar, charSnap)) {
                    throw new WriteError('write', i18n('Failed to persist character override.'));
                }
                await copyOrchPresetSkills(ctx, { mode: target.mode, oldName, newName: name });
                return;
            }
            const ok = await persistGlobalWithRollback(ctx, settings, target.mode, globalSnap, {
                operation: { action: 'duplicate', id, sourceId: target.presetId, oldName, newName: name },
            });
            if (!ok) {
                throw new WriteError('write', i18n('Failed to save the settings'));
            }
        },

        async rename(target, name) {
            const { ctx, settings } = host();
            const scope = scopeOf(target);
            const oldName = nameOf(ctx, settings, target.mode, scope, target.avatar, target.presetId);
            const charSnap = scope === 'character' ? snapshotCharacterOrchestratorState(ctx, target.avatar) : null;
            const globalSnap = scope === 'global' ? snapshotGlobalPresetState(settings, target.mode) : null;
            if (!renamePreset(settings, target.mode, scope, target.presetId, { name }, opts(ctx, target.avatar))) {
                restoreCharacterOrchestratorState(ctx, charSnap);
                restoreGlobalPresetState(settings, globalSnap);
                throw new WriteError('write', i18n('Could not save the preset.'));
            }
            captureGlobalPresetMutation(globalSnap, settings);
            captureCharacterOrchestratorMutation(charSnap, ctx);
            refreshed(ctx);
            await notifyOrRollback(ctx, settings, globalSnap, charSnap);
            if (scope === 'character') {
                if (!await persistCharacterWithRollback(ctx, target.avatar, charSnap)) {
                    throw new WriteError('write', i18n('Failed to persist character override.'));
                }
                await renameOrchPresetSkills(ctx, { mode: target.mode, oldName, newName: name });
                return;
            }
            const ok = await persistGlobalWithRollback(ctx, settings, target.mode, globalSnap, {
                operation: { action: 'rename', id: target.presetId, oldName, newName: name },
            });
            if (!ok) {
                throw new WriteError('write', i18n('Failed to save the settings'));
            }
        },

        async remove(target) {
            const { ctx, settings } = host();
            const scope = scopeOf(target);
            const name = nameOf(ctx, settings, target.mode, scope, target.avatar, target.presetId);
            const charSnap = scope === 'character' ? snapshotCharacterOrchestratorState(ctx, target.avatar) : null;
            const globalSnap = scope === 'global' ? snapshotGlobalPresetState(settings, target.mode) : null;
            if (!deletePreset(settings, target.mode, scope, target.presetId, opts(ctx, target.avatar))) {
                restoreCharacterOrchestratorState(ctx, charSnap);
                restoreGlobalPresetState(settings, globalSnap);
                throw new WriteError('write', i18n('Could not save the preset.'));
            }
            captureGlobalPresetMutation(globalSnap, settings);
            captureCharacterOrchestratorMutation(charSnap, ctx);
            refreshed(ctx);
            await notifyOrRollback(ctx, settings, globalSnap, charSnap);
            if (scope === 'character') {
                if (!await persistCharacterWithRollback(ctx, target.avatar, charSnap)) {
                    throw new WriteError('write', i18n('Failed to persist character override.'));
                }
                await emitOrchPresetDeleted(ctx, { mode: target.mode, name });
                return;
            }
            const ok = await persistGlobalWithRollback(ctx, settings, target.mode, globalSnap, {
                operation: { action: 'delete', id: target.presetId, oldName: name },
            });
            if (!ok) {
                throw new WriteError('write', i18n('Failed to save the settings'));
            }
        },

        async exportActive(target) {
            const { ctx, settings } = host();
            const scope = scopeOf(target);
            const active = getActivePreset(settings, target.mode, { scope, ...opts(ctx, target.avatar) }).state;
            if (!active) throw new WriteError('no-preset', i18n('No active preset to export.'));
            const payload = buildPortablePayloadForMode(target.mode, active);
            await emitOrchPresetExportReady(ctx, payload);
            const slug = String(active.name || 'preset').trim().replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'preset';
            downloadJson(`luker-orchestrator-${target.mode}-${scope}-${slug}.json`, payload);
        },

        /** Reads a preset file; the caller asks for the name, then calls `importParsed`. */
        parseImport(target, fileText) {
            const imported = parseImportedProfilePayload(fileText);
            if (imported.mode !== target.mode) throw new WriteError('mode', i18n('Imported file does not match the current mode.'));
            return { imported, fileText, defaultName: String(extractImportedProfileForMode(imported)?.name || '').trim() };
        },

        async importParsed(target, { imported, fileText }, name) {
            const { ctx, settings } = host();
            const scope = scopeOf(target);
            const { mode } = target;
            const profile = extractImportedProfileForMode(imported);
            const charSnap = scope === 'character' ? snapshotCharacterOrchestratorState(ctx, target.avatar) : null;
            const globalSnap = scope === 'global' ? snapshotGlobalPresetState(settings, mode) : null;
            const id = createPreset(settings, mode, scope, { name }, opts(ctx, target.avatar));
            if (!id || !setActivePresetId(settings, mode, scope, id, opts(ctx, target.avatar))) {
                restoreCharacterOrchestratorState(ctx, charSnap);
                restoreGlobalPresetState(settings, globalSnap);
                throw new WriteError('write', i18n('Could not create the preset.'));
            }
            const writeResult = writeActivePreset(settings, mode, scope, profile, opts(ctx, target.avatar));
            if (!writeResult.ok) {
                restoreCharacterOrchestratorState(ctx, charSnap);
                restoreGlobalPresetState(settings, globalSnap);
                refreshed(ctx);
                throw new WriteError('write', writeResult.hint || writeResult.reason);
            }
            captureGlobalPresetMutation(globalSnap, settings);
            captureCharacterOrchestratorMutation(charSnap, ctx);
            refreshed(ctx);
            await notifyOrRollback(ctx, settings, globalSnap, charSnap);
            if (scope === 'character') {
                if (!await persistCharacterWithRollback(ctx, target.avatar, charSnap)) {
                    throw new WriteError('write', i18n('Failed to persist character override.'));
                }
            } else if (!await persistGlobalWithRollback(ctx, settings, mode, globalSnap)) {
                throw new WriteError('write', i18n('Failed to save the settings'));
            }
            const data = { ...profile };
            const envelope = JSON.parse(fileText);
            if (envelope?.extensions) data.extensions = envelope.extensions;
            await emitOrchPresetImportReady(ctx, { data, mode, name });
            refreshed(ctx);
        },

        /** Copies the profile on screen over the global active preset. */
        async saveToGlobal(target, profileOnScreen = null) {
            const { ctx, settings } = host();
            const current = profileOnScreen
                ? clone(profileOnScreen)
                : getPreset(settings, target.mode, scopeOf(target), target.presetId, opts(ctx, target.avatar));
            if (!current) throw new WriteError('target-gone', i18n('The profile to edit was deleted'));
            const { name: _name, ...body } = current;
            const ok = await persistGlobalPresetWrite(
                settings,
                target.mode,
                () => {
                    getActivePreset(settings, target.mode, { scope: 'global', ...opts(ctx, target.avatar) });
                    return writeActivePreset(settings, target.mode, 'global', body, opts(ctx, target.avatar));
                },
                {
                    context: ctx,
                    replaceGlobal: scopeOf(target) === 'global',
                },
            );
            if (!ok) throw new WriteError('write', i18n('Failed to save the settings'));
            refreshed(ctx);
        },

        /** Copies the profile on screen (or global active preset) onto the current character card. */
        async saveToCharacter(target, profileOnScreen = null) {
            const { ctx, settings } = host();
            const { mode, avatar } = target;
            if (!avatar) throw new WriteError('no-character', i18n('No character selected.'));
            const load = { loop: loadGlobalLoopEditorState, agenda: loadGlobalAgendaEditorState, director: loadGlobalDirectorEditorState, spec: loadGlobalEditorState }[mode];
            const persist = { loop: persistCharacterLoopEditor, agenda: persistCharacterAgendaEditor, director: persistCharacterDirectorEditor, spec: persistCharacterEditor }[mode];
            const editor = profileOnScreen ? toCharacterEditorFromProfile(mode, profileOnScreen) : load();
            const preflight = await promptEmbedUnembeddedPresetsForCharacterApply({
                context: ctx,
                activeCharacter: ctx.characters?.find(c => c?.avatar === avatar) || null,
                profile: { ...editor, mode },
                i18n,
                i18nFormat,
                notifyError: (text) => toastr.error(String(text)),
                escapeHtml: (text) => $('<div>').text(String(text ?? '')).html(),
            });
            if (!preflight.proceed) return false;
            if (!await persist(ctx, settings, avatar, { editor })) throw new WriteError('write', i18n('Failed to persist character override.'));
            refreshed(ctx);
            return true;
        },

        async clearCharacter(target) {
            const { ctx, settings } = host();
            const index = getCharacterIndexByAvatar(ctx, target.avatar);
            if (index < 0) throw new WriteError('no-character', i18n('No character selected.'));
            const next = clearCharacterExtensionForMode(getCharacterExtensionDataByAvatar(ctx, target.avatar), target.mode);
            if (!await persistOrchestratorCharacterExtension(ctx, index, next)) throw new WriteError('write', i18n('Failed to persist character override.'));
            applyCharacterExecutionModeForAvatar(ctx, settings, target.avatar);
            refreshed(ctx);
        },

        /** Pins the mode this card runs in ('' removes the pin). */
        async pinMode(target, mode) {
            const { ctx, settings } = host();
            const index = getCharacterIndexByAvatar(ctx, target.avatar);
            if (index < 0) throw new WriteError('no-character', i18n('No character selected.'));
            const ext = clone(getCharacterExtensionDataByAvatar(ctx, target.avatar) || {});
            ext.override = { ...(ext.override || {}) };
            if (mode) ext.override.mode = mode; else delete ext.override.mode;
            if (!await persistOrchestratorCharacterExtension(ctx, index, ext)) throw new WriteError('write', i18n('Failed to persist character override.'));
            if (mode) applyCharacterExecutionModeForAvatar(ctx, settings, target.avatar);
            refreshed(ctx);
        },

        async resetSingle() {
            const { ctx, settings } = host();
            await saveFields(ctx, settings, { singleAgentSystemPrompt: DEFAULT_SINGLE_AGENT_SYSTEM_PROMPT, singleAgentUserPromptTemplate: DEFAULT_SINGLE_AGENT_USER_PROMPT_TEMPLATE });
            refreshed(ctx);
        },

        async saveCustomTools(target, tools) {
            const { ctx, settings } = host();
            if (getActivePresetId(settings, target.mode, { scope: scopeOf(target), context: ctx, avatar: target.avatar }) !== target.presetId) throw new WriteError('target-gone', i18n('Preset no longer exists — refreshing the list.'));
            if (!await persistCustomToolsKeepingDrafts(ctx, settings, target.mode, scopeOf(target), tools, { avatar: target.avatar })) throw new WriteError('write', i18n('Failed to persist character override.'));
        },
    };
}

const intAtLeast = (min, fallback) => (value) => Math.max(min, Math.floor(Number(value) || fallback));
const text = (value) => String(value || '');
const ROLES = [0, 1, 2]; // extension_prompt_roles: system, user, assistant
const SETTING_RULES = {
    llmNodeApiPresetName: sanitizeConnectionProfileName,
    llmNodePresetName: value => text(value).trim(),
    includeWorldInfoWithPreset: Boolean,
    nodeIterationMaxRounds: intAtLeast(1, 40),
    reviewRerunMaxRounds: intAtLeast(0, 0),
    maxRecentMessages: intAtLeast(1, 14),
    toolCallRetryMax: intAtLeast(0, 0),
    rpmLimit: intAtLeast(0, 0),
    capsuleInjectPosition: normalizeCapsuleInjectPosition,
    capsuleInjectDepth: intAtLeast(0, 0),
    capsuleInjectRole: value => (ROLES.includes(Number(value)) ? Number(value) : 0),
    capsuleCustomInstruction: text,
    requestApiPresetName: sanitizeConnectionProfileName,
    requestLlmPresetName: value => text(value).trim(),
    requestSystemPrompt: text,
    iterModePromptSpec: text,
    iterModePromptLoop: text,
    iterModePromptDirector: text,
    iterModePromptAgenda: text,
};
const CAPSULE_KEYS = ['capsuleInjectPosition', 'capsuleInjectDepth', 'capsuleInjectRole', 'capsuleCustomInstruction'];

/** Settings shared by every profile, plus the limits stored per preset. */
export function createSettingsAccess(host) {
    const api = (ctx) => ctx.getExtensionApi('orchestrator');
    return {
        values() {
            const { settings } = host();
            return Object.fromEntries(Object.keys(SETTING_RULES).map(key => [key, settings[key]]));
        },
        set(key, value) {
            const { ctx, settings } = host();
            if (!SETTING_RULES[key]) return;
            settings[key] = SETTING_RULES[key](value);
            if (CAPSULE_KEYS.includes(key)) api(ctx)?.reapplyCapsule?.();
            persistHostSettings(ctx).catch(err => globalThis.toastr?.error?.(String(err?.message || err)));
        },
        promptDefaults() {
            const { ctx } = host();
            return api(ctx)?.getIterationPromptDefaults?.() || {};
        },
        /** Limits live inside the active preset of agenda / loop / director. */
        async setLimit(target, patch) {
            const { ctx, settings } = host();
            if (getActivePresetId(settings, target.mode, { scope: scopeOf(target), context: ctx, avatar: target.avatar }) !== target.presetId) throw new WriteError('target-gone', i18n('Preset no longer exists — refreshing the list.'));
            if (!await persistRuntimeLimitsKeepingDrafts(ctx, settings, target.mode, scopeOf(target), patch, { avatar: target.avatar })) throw new WriteError('write', i18n('Failed to persist character override.'));
        },
    };
}
