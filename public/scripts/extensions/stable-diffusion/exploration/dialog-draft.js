// SPDX-License-Identifier: AGPL-3.0-or-later

import {
    CHARACTER_PROFILES_NAMESPACE,
    normalizeReferenceImageEntry,
    profileVersion,
} from '../character-archive/store.js';
import { makeIllustrationId } from '../illustration/presets.js';
import { i18n } from '../lens/i18n.js';
import { normalizeLocalImagePath } from '../media-path.js';

export const DRAFT_FIELD_KEYS = Object.freeze([
    'name',
    'aliases',
    'sourceWork',
    'description',
    'referenceImages',
]);

const PATCH_KEY_MAP = Object.freeze({
    name: 'name',
    aliases: 'aliases',
    sourceWork: 'sourceWork',
    source_work: 'sourceWork',
    description: 'description',
    referenceImages: 'referenceImages',
    reference_images: 'referenceImages',
});

function deepClone(value) {
    return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function cleanStringList(list) {
    if (!Array.isArray(list)) {
        return [];
    }
    const out = [];
    const seen = new Set();
    for (const item of list) {
        const trimmed = String(item ?? '').trim();
        if (!trimmed || seen.has(trimmed)) {
            continue;
        }
        seen.add(trimmed);
        out.push(trimmed);
    }
    return out;
}

function normalizeDraftReferenceImages(list, { trimLabel = true } = {}) {
    if (!Array.isArray(list)) {
        return [];
    }
    const out = [];
    const byPath = new Map();
    for (const item of list) {
        let entry;
        if (typeof item === 'string') {
            const path = item.trim();
            entry = path ? { path, label: '' } : null;
        } else if (item && typeof item === 'object' && !Array.isArray(item)) {
            const path = typeof item.path === 'string' ? item.path.trim() : '';
            if (!path) {
                entry = null;
            } else {
                const rawLabel = String(item.label ?? '');
                entry = { path, label: trimLabel ? rawLabel.trim() : rawLabel };
            }
        } else {
            entry = null;
        }
        if (!entry) {
            continue;
        }
        const existing = byPath.get(entry.path);
        if (existing) {
            if (!existing.label.trim() && entry.label.trim()) {
                existing.label = entry.label;
            }
            continue;
        }
        byPath.set(entry.path, entry);
        out.push(entry);
    }
    return out;
}

function createInitialDraftState(initialProfile) {
    if (!initialProfile || typeof initialProfile !== 'object') {
        return {
            id: makeIllustrationId('char'),
            name: '',
            aliases: [],
            sourceWork: '',
            description: '',
            referenceImages: [],
        };
    }
    return {
        id: String(initialProfile.id || '').trim() || makeIllustrationId('char'),
        name: String(initialProfile.name || ''),
        aliases: cleanStringList(initialProfile.aliases),
        sourceWork: String(initialProfile.sourceWork || ''),
        description: String(initialProfile.description || ''),
        referenceImages: normalizeDraftReferenceImages(initialProfile.referenceImages),
        ...(Number.isFinite(Number(initialProfile.createdAt)) ? { createdAt: Number(initialProfile.createdAt) } : {}),
        ...(Number.isFinite(Number(initialProfile.updatedAt)) ? { updatedAt: Number(initialProfile.updatedAt) } : {}),
    };
}

function normalizeFieldForPatch(field, value) {
    switch (field) {
        case 'name':
        case 'sourceWork':
        case 'description':
            return String(value ?? '').trim();
        case 'aliases':
            return cleanStringList(value);
        case 'referenceImages':
            return normalizeDraftReferenceImages(value, { trimLabel: true });
        default:
            throw new Error(`Unsupported draft field "${field}".`);
    }
}

function normalizeFieldForManualEdit(field, value) {
    switch (field) {
        case 'name':
        case 'sourceWork':
        case 'description':
            return String(value ?? '');
        case 'aliases':
            return cleanStringList(value);
        case 'referenceImages':
            return normalizeDraftReferenceImages(value, { trimLabel: false });
        default:
            throw new Error(`Unsupported draft field "${field}".`);
    }
}

function canonicalValue(field, value) {
    return JSON.stringify(normalizeFieldForPatch(field, value));
}

export function isStagedTempImagePath(imagePath) {
    const raw = String(imagePath || '').trim();
    if (!raw) return false;
    try {
        return normalizeLocalImagePath(raw).toLowerCase().startsWith('/user/images/_sandbox_tmp/');
    } catch {
        return false;
    }
}

export function collectRetainedTempPaths(profile) {
    const out = [];
    const seen = new Set();
    for (const item of Array.isArray(profile?.referenceImages) ? profile.referenceImages : []) {
        const entry = normalizeReferenceImageEntry(item);
        if (!entry || !isStagedTempImagePath(entry.path)) continue;
        const key = normalizeLocalImagePath(entry.path);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(entry.path);
    }
    return out;
}

export function createCharacterDraft(initialProfile = null) {
    const profile = createInitialDraftState(initialProfile);
    const manualRevisions = Object.fromEntries(DRAFT_FIELD_KEYS.map(key => [key, 0]));
    const conflictsByPath = new Map();

    function applyReferenceImageSubPath(segments, value) {
        const [, targetIndex, prop] = segments;
        if (!/^\d+$/.test(String(targetIndex ?? '')) || prop !== 'label') {
            throw new Error(`Unsupported draft path "referenceImages.${segments.slice(1).join('.')}".`);
        }
        const index = Number(targetIndex);
        if (index < 0 || index >= profile.referenceImages.length) {
            throw new Error(`Reference image at index ${index} was not found in the draft.`);
        }
        const nextRefs = deepClone(profile.referenceImages);
        nextRefs[index].label = String(value ?? '');
        profile.referenceImages = nextRefs;
    }

    return {
        getSnapshot() {
            return deepClone(profile);
        },

        getConflicts() {
            return [...conflictsByPath.values()].map(deepClone);
        },

        edit(path, value) {
            const rawPath = String(path || '').trim();
            if (!rawPath) {
                throw new Error('Draft edit path must be a non-empty string.');
            }
            const segments = rawPath.split('.');
            const topField = PATCH_KEY_MAP[segments[0]] || segments[0];
            if (!DRAFT_FIELD_KEYS.includes(topField)) {
                throw new Error(`Unsupported draft edit path "${rawPath}".`);
            }

            if (topField === 'referenceImages' && segments.length > 1) {
                applyReferenceImageSubPath(segments, value);
            } else {
                profile[topField] = normalizeFieldForManualEdit(topField, value);
            }

            manualRevisions[topField] += 1;
            const existingConflict = conflictsByPath.get(topField);
            if (existingConflict) {
                existingConflict.manualValue = deepClone(profile[topField]);
            }
            return deepClone(profile);
        },

        beginTurn() {
            return {
                profile: deepClone(profile),
                manualRevisions: { ...manualRevisions },
            };
        },

        applyAgentPatch(patch, turnSnapshot = null) {
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
                throw new Error('stage_character_profile: invalid_args — patch must be an object');
            }

            const baseRevisions = turnSnapshot?.manualRevisions || {};
            const baseProfile = turnSnapshot?.profile || null;
            const changes = [];
            const conflicts = [];

            const resolvedFields = new Map();
            for (const [rawKey, field] of Object.entries(PATCH_KEY_MAP)) {
                if (Object.hasOwn(patch, rawKey) && patch[rawKey] !== undefined) {
                    resolvedFields.set(field, patch[rawKey]);
                }
            }

            for (const [field, rawValue] of resolvedFields.entries()) {
                const nextValue = normalizeFieldForPatch(field, rawValue);
                if (canonicalValue(field, profile[field]) === canonicalValue(field, nextValue)) {
                    continue;
                }

                const baseRev = Number(baseRevisions[field] || 0);
                if (manualRevisions[field] > baseRev) {
                    const conflict = {
                        id: `conflict_${field}`,
                        path: field,
                        manualValue: deepClone(profile[field]),
                        agentValue: deepClone(nextValue),
                        ...(baseProfile ? { baseValue: deepClone(baseProfile[field]) } : {}),
                    };
                    conflictsByPath.set(field, conflict);
                    conflicts.push(deepClone(conflict));
                    continue;
                }

                const previousValue = deepClone(profile[field]);
                profile[field] = deepClone(nextValue);
                conflictsByPath.delete(field);
                changes.push({
                    path: field,
                    previousValue,
                    nextValue: deepClone(nextValue),
                });
            }

            return { changes, conflicts };
        },

        resolveConflict(id, choice) {
            if (choice !== 'keep_manual' && choice !== 'accept_agent') {
                throw new Error(`Invalid conflict resolution choice "${choice}". Expected "keep_manual" or "accept_agent".`);
            }
            const entry = [...conflictsByPath.values()].find(item => item.id === id);
            if (!entry) {
                throw new Error(`Draft conflict "${id}" was not found.`);
            }
            if (choice === 'accept_agent') {
                profile[entry.path] = deepClone(entry.agentValue);
            }
            conflictsByPath.delete(entry.path);
            return {
                id: entry.id,
                path: entry.path,
                choice,
                profile: deepClone(profile),
            };
        },
    };
}

export async function commitCharacterDraft({
    draft,
    initialVersion = null,
    store,
    tracker,
    now = Date.now(),
}) {
    const unresolved = draft.getConflicts();
    if (unresolved.length > 0) {
        throw new Error(i18n('Resolve all draft conflicts before saving.'));
    }

    const snapshot = draft.getSnapshot();
    if (!String(snapshot.name || '').trim()) {
        throw new Error(i18n('Character profile requires a non-empty name.'));
    }

    const retainedTempPaths = collectRetainedTempPaths(snapshot);
    await tracker.ready();
    const promoted = await tracker.promote(retainedTempPaths, {
        profileId: snapshot.id,
        namespace: CHARACTER_PROFILES_NAMESPACE,
    });

    const promotedMap = new Map();
    for (const item of Array.isArray(promoted?.images) ? promoted.images : []) {
        if (!item?.sourcePath || !item?.imagePath) continue;
        promotedMap.set(item.sourcePath, item.imagePath);
        promotedMap.set(normalizeLocalImagePath(item.sourcePath), item.imagePath);
    }

    const profileToSave = deepClone(snapshot);
    profileToSave.referenceImages = normalizeDraftReferenceImages(profileToSave.referenceImages).map(entry => {
        const direct = promotedMap.get(entry.path);
        if (direct) return { path: direct, label: entry.label };
        if (isStagedTempImagePath(entry.path)) {
            const normalized = promotedMap.get(normalizeLocalImagePath(entry.path));
            if (normalized) return { path: normalized, label: entry.label };
        }
        return { path: entry.path, label: entry.label };
    });

    let saved;
    try {
        saved = await store.upsertProfile(profileToSave, now, {
            expectedVersion: initialVersion,
            transientSessionId: tracker.sessionId,
        });
    } catch (saveError) {
        try {
            await tracker.rollback(promoted.promotionId);
        } catch (rollbackError) {
            throw new Error(
                `${String(saveError?.message || saveError)} (Rollback also failed: ${String(rollbackError?.message || rollbackError)})`,
            );
        }
        throw saveError;
    }

    let cleanupWarning = '';
    try {
        await tracker.complete(promoted.promotionId);
    } catch (completeError) {
        cleanupWarning = String(completeError?.message || completeError);
        console.error('[sd/dialog-draft] Failed to finalize temporary promotion after profile save:', completeError);
    }
    return {
        saved,
        savedVersion: profileVersion(saved),
        promotionId: promoted.promotionId,
        promotedImages: Array.isArray(promoted?.images) ? promoted.images : [],
        ...(cleanupWarning ? { cleanupWarning } : {}),
    };
}
