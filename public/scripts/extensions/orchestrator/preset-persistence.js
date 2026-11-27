// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Unified persistence, monotonic write-epoch tracking, and rollback
// coordination for orchestrator global settings and character card overrides.
// Shared by editor-persist.js and lens/source-write.js so concurrent writes
// across both surfaces never clobber each other via stale rollbacks.

import { canonicalStringify } from './canonical-stringify.js';

const clone = (value) => (value == null ? value : JSON.parse(JSON.stringify(value)));

function findCharacterIndexByAvatar(ctx, avatar) {
    const target = String(avatar || '');
    if (!target || !Array.isArray(ctx?.characters)) return -1;
    return ctx.characters.findIndex(c => String(c?.avatar || '') === target);
}

let nextWriteEpoch = 0;
const globalWriteEpochs = new Map();
const characterWriteEpochs = new Map();
const globalPresetLifecycle = new Map();

export function bumpGlobalWriteEpoch(mode) {
    const key = String(mode || '');
    const epoch = ++nextWriteEpoch;
    globalWriteEpochs.set(key, epoch);
    return epoch;
}

export function bumpCharacterWriteEpoch(avatar) {
    const key = String(avatar || '');
    if (!key) return 0;
    const epoch = ++nextWriteEpoch;
    characterWriteEpochs.set(key, epoch);
    return epoch;
}

export function snapshotGlobalPresetState(settings, mode) {
    const hadLibraries = Object.prototype.hasOwnProperty.call(settings, 'presetLibraries');
    const hadModeLibrary = Boolean(hadLibraries && settings.presetLibraries && Object.prototype.hasOwnProperty.call(settings.presetLibraries, mode));
    const hadActiveIds = Object.prototype.hasOwnProperty.call(settings, 'activePresetIds');
    const hadModeActive = Boolean(hadActiveIds && settings.activePresetIds && Object.prototype.hasOwnProperty.call(settings.activePresetIds, mode));
    return {
        mode,
        hadLibraries,
        hadModeLibrary,
        prevLibrary: hadModeLibrary ? clone(settings.presetLibraries[mode]) : undefined,
        hadActiveIds,
        hadModeActive,
        prevActive: hadModeActive ? settings.activePresetIds[mode] : undefined,
    };
}

export function captureGlobalPresetMutation(snap, settings) {
    if (!snap) return;
    snap.prevEpoch = globalWriteEpochs.get(snap.mode) || 0;
    snap.epoch = bumpGlobalWriteEpoch(snap.mode);
    snap.expectedLibraryJson = canonicalStringify(settings.presetLibraries?.[snap.mode]);
    snap.expectedActive = settings.activePresetIds?.[snap.mode];
}

export function restoreGlobalPresetState(settings, snap) {
    if (!snap) return false;
    const hasExpected = Object.prototype.hasOwnProperty.call(snap, 'expectedLibraryJson');
    if (hasExpected) {
        const epochMatches = globalWriteEpochs.get(snap.mode) === snap.epoch;
        const libraryMatches = canonicalStringify(settings.presetLibraries?.[snap.mode]) === snap.expectedLibraryJson;
        const activeMatches = settings.activePresetIds?.[snap.mode] === snap.expectedActive;
        // Both fields persist together and epochs prevent ABA clobbering;
        // if a newer operation touched this mode, skip rollback.
        if (!epochMatches || !libraryMatches || !activeMatches) {
            return false;
        }
    }
    if (snap.hadLibraries && settings.presetLibraries) {
        if (snap.hadModeLibrary) {
            settings.presetLibraries[snap.mode] = clone(snap.prevLibrary);
        } else {
            delete settings.presetLibraries[snap.mode];
        }
    } else if (!snap.hadLibraries) {
        delete settings.presetLibraries;
    }
    if (snap.hadActiveIds && settings.activePresetIds) {
        if (snap.hadModeActive) {
            settings.activePresetIds[snap.mode] = snap.prevActive;
        } else {
            delete settings.activePresetIds[snap.mode];
        }
    } else if (!snap.hadActiveIds) {
        delete settings.activePresetIds;
    }
    if (hasExpected) {
        globalWriteEpochs.set(snap.mode, snap.prevEpoch);
    }
    return true;
}

export function snapshotCharacterOrchestratorState(ctx, avatar) {
    if (!avatar) return null;
    const idx = findCharacterIndexByAvatar(ctx, avatar);
    if (idx < 0) return null;
    const extObj = ctx.characters?.[idx]?.data?.extensions;
    if (!extObj) return null;
    const hadKey = Object.prototype.hasOwnProperty.call(extObj, 'orchestrator');
    return { avatar: String(avatar), hadKey, prev: hadKey ? clone(extObj.orchestrator) : undefined };
}

export function captureCharacterOrchestratorMutation(snap, ctx) {
    if (!snap?.avatar) return;
    const idx = findCharacterIndexByAvatar(ctx, snap.avatar);
    const extObj = idx >= 0 ? ctx.characters?.[idx]?.data?.extensions : null;
    snap.prevEpoch = characterWriteEpochs.get(snap.avatar) || 0;
    snap.epoch = bumpCharacterWriteEpoch(snap.avatar);
    snap.expectedHasKey = Boolean(extObj && Object.prototype.hasOwnProperty.call(extObj, 'orchestrator'));
    snap.expectedJson = snap.expectedHasKey ? canonicalStringify(extObj.orchestrator) : undefined;
}

export function restoreCharacterOrchestratorState(ctx, snap) {
    if (!snap?.avatar) return false;
    const idx = findCharacterIndexByAvatar(ctx, snap.avatar);
    if (idx < 0) return false;
    const extObj = ctx.characters?.[idx]?.data?.extensions;
    if (!extObj) return false;
    const hasExpected = Object.prototype.hasOwnProperty.call(snap, 'expectedHasKey');
    if (hasExpected) {
        const epochMatches = characterWriteEpochs.get(snap.avatar) === snap.epoch;
        const currentHasKey = Object.prototype.hasOwnProperty.call(extObj, 'orchestrator');
        const currentJson = currentHasKey ? canonicalStringify(extObj.orchestrator) : undefined;
        if (!epochMatches || currentHasKey !== snap.expectedHasKey || currentJson !== snap.expectedJson) {
            return false;
        }
    }
    if (snap.hadKey) {
        extObj.orchestrator = clone(snap.prev);
    } else {
        delete extObj.orchestrator;
    }
    if (hasExpected) {
        characterWriteEpochs.set(snap.avatar, snap.prevEpoch);
    }
    return true;
}

// Persistent operations follow acknowledgement order, not UI selection. Keep
// the last skill scope for each opaque preset id so A->B->C and rename->delete
// compose even while earlier responses or secondary operations are pending.
function enqueueGlobalPresetLifecycle(context, mode, operation, pending, lifecycleHooks = null) {
    if (!operation || !lifecycleHooks) return pending;
    let queue = globalPresetLifecycle.get(mode);
    if (!queue) {
        queue = { tail: Promise.resolve(), names: new Map() };
        globalPresetLifecycle.set(mode, queue);
    }
    if (!queue.names.has(operation.id)) {
        queue.names.set(operation.id, operation.action === 'duplicate' ? operation.newName : operation.oldName);
    }
    const previous = queue.tail;
    const next = (async () => {
        await previous;
        if (!await pending) return false;
        const oldName = queue.names.get(operation.id);
        if (operation.action === 'rename') {
            const ok = await lifecycleHooks.renameOrchPresetSkills(context, { mode, oldName, newName: operation.newName });
            if (ok !== false) queue.names.set(operation.id, operation.newName);
        } else if (operation.action === 'delete') {
            await lifecycleHooks.emitOrchPresetDeleted(context, { mode, name: oldName });
            queue.names.delete(operation.id);
        } else {
            const sourceName = queue.names.get(operation.sourceId) ?? operation.oldName;
            await lifecycleHooks.copyOrchPresetSkills(context, { mode, oldName: sourceName, newName: operation.newName });
            queue.names.set(operation.id, operation.newName);
        }
        return true;
    })();
    queue.tail = next.catch(() => {});
    return next;
}

export async function saveSettingsCheckedThroughContext(ctx) {
    if (typeof ctx?.workbench?.saveSettingsChecked === 'function') {
        await ctx.workbench.saveSettingsChecked(ctx);
        return;
    }
    if (typeof ctx?.saveSettings !== 'function') {
        throw new Error('Failed to save the settings: saveSettings is unavailable');
    }
    let saved = false;
    await ctx.saveSettings(0, { onSaved: () => { saved = true; } });
    if (!saved) {
        throw new Error('Failed to save the settings');
    }
}

export function persistGlobalLibraryWithLifecycle(ctx, settings, mode, { operation = null, directSave = false, lifecycleHooks = null } = {}) {
    const activeId = settings.activePresetIds?.[mode];
    const libraryJson = canonicalStringify(settings.presetLibraries?.[mode]);
    const pending = (typeof ctx?.saveSettings === 'function'
        ? Promise.resolve().then(() => ctx.saveSettings(0, directSave ? { directSave: true } : undefined)).then((outcome) => {
            if (!outcome || typeof outcome !== 'object') return false;
            if (!outcome.ok) return false;
            if (!outcome.payload) return true;
            const saved = outcome.payload?.extension_settings?.orchestrator;
            return saved?.activePresetIds?.[mode] === activeId
                && canonicalStringify(saved?.presetLibraries?.[mode]) === libraryJson;
        })
        : saveSettingsCheckedThroughContext(ctx).then(() => true));
    return enqueueGlobalPresetLifecycle(ctx, mode, operation, pending, lifecycleHooks);
}
