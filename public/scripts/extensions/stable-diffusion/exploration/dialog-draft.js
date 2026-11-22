// SPDX-License-Identifier: AGPL-3.0-or-later

import {
    CHARACTER_PROFILES_NAMESPACE,
    normalizeCharacterOutfit,
    profileVersion,
} from '../character-archive/store.js';
import { makeIllustrationId } from '../illustration/presets.js';
import { i18n } from '../lens/i18n.js';
import { normalizeLocalImagePath } from '../media-path.js';

export const DRAFT_FIELD_KEYS = Object.freeze([
    'name',
    'aliases',
    'sourceWork',
    'canonicalTags',
    'negativeTags',
    'proseDescription',
    'outfits',
    'defaultOutfitId',
]);

const PATCH_KEY_MAP = Object.freeze({
    name: 'name',
    aliases: 'aliases',
    sourceWork: 'sourceWork',
    source_work: 'sourceWork',
    canonicalTags: 'canonicalTags',
    canonical_tags: 'canonicalTags',
    negativeTags: 'negativeTags',
    negative_tags: 'negativeTags',
    proseDescription: 'proseDescription',
    prose_description: 'proseDescription',
    outfits: 'outfits',
    defaultOutfitId: 'defaultOutfitId',
    default_outfit_id: 'defaultOutfitId',
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

function normalizeDraftOutfits(rawOutfits, { allowEmpty = false } = {}) {
    const list = Array.isArray(rawOutfits)
        ? rawOutfits.map((entry, idx) => normalizeCharacterOutfit(entry, idx)).filter(Boolean)
        : [];
    if (list.length === 0 && !allowEmpty) {
        list.push({
            id: 'outfit_default',
            name: 'Default',
            tags: [],
            prose: '',
            referenceImages: [],
        });
    }
    return list;
}

function createInitialDraftState(initialProfile) {
    if (!initialProfile || typeof initialProfile !== 'object') {
        return {
            id: makeIllustrationId('char'),
            name: '',
            aliases: [],
            sourceWork: '',
            canonicalTags: [],
            negativeTags: [],
            proseDescription: '',
            outfits: [
                {
                    id: 'outfit_default',
                    name: 'Default',
                    tags: [],
                    prose: '',
                    referenceImages: [],
                },
            ],
            defaultOutfitId: 'outfit_default',
        };
    }
    const outfits = normalizeDraftOutfits(initialProfile.outfits);
    const requestedDefault = String(initialProfile.defaultOutfitId || '').trim();
    const defaultOutfitId = outfits.some(o => o.id === requestedDefault)
        ? requestedDefault
        : outfits[0].id;
    return {
        id: String(initialProfile.id || '').trim() || makeIllustrationId('char'),
        name: String(initialProfile.name || ''),
        aliases: cleanStringList(initialProfile.aliases),
        sourceWork: String(initialProfile.sourceWork || ''),
        canonicalTags: cleanStringList(initialProfile.canonicalTags),
        negativeTags: cleanStringList(initialProfile.negativeTags),
        proseDescription: String(initialProfile.proseDescription || ''),
        outfits,
        defaultOutfitId,
        ...(Number.isFinite(Number(initialProfile.createdAt)) ? { createdAt: Number(initialProfile.createdAt) } : {}),
        ...(Number.isFinite(Number(initialProfile.updatedAt)) ? { updatedAt: Number(initialProfile.updatedAt) } : {}),
    };
}

function normalizeFieldForPatch(field, value) {
    switch (field) {
        case 'name':
        case 'sourceWork':
        case 'proseDescription':
        case 'defaultOutfitId':
            return String(value ?? '').trim();
        case 'aliases':
        case 'canonicalTags':
        case 'negativeTags':
            return cleanStringList(value);
        case 'outfits':
            return normalizeDraftOutfits(value);
        default:
            throw new Error(`Unsupported draft field "${field}".`);
    }
}

function normalizeFieldForManualEdit(field, value) {
    switch (field) {
        case 'name':
        case 'sourceWork':
        case 'proseDescription':
        case 'defaultOutfitId':
            return String(value ?? '');
        case 'aliases':
        case 'canonicalTags':
        case 'negativeTags':
            return cleanStringList(value);
        case 'outfits':
            return Array.isArray(value)
                ? value.map((entry, idx) => ({
                    id: String(entry?.id || '').trim() || makeIllustrationId(`outfit_${idx + 1}`),
                    name: String(entry?.name ?? ''),
                    tags: cleanStringList(entry?.tags),
                    prose: String(entry?.prose ?? ''),
                    referenceImages: cleanStringList(entry?.referenceImages ?? entry?.reference_images),
                }))
                : [];
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
    for (const outfit of Array.isArray(profile?.outfits) ? profile.outfits : []) {
        for (const imagePath of Array.isArray(outfit?.referenceImages) ? outfit.referenceImages : []) {
            const trimmed = String(imagePath || '').trim();
            if (!trimmed || !isStagedTempImagePath(trimmed)) continue;
            const key = normalizeLocalImagePath(trimmed);
            if (seen.has(key)) continue;
            seen.add(key);
            out.push(trimmed);
        }
    }
    return out;
}

export function createCharacterDraft(initialProfile = null) {
    const profile = createInitialDraftState(initialProfile);
    const manualRevisions = Object.fromEntries(DRAFT_FIELD_KEYS.map(key => [key, 0]));
    const conflictsByPath = new Map();

    function syncDefaultOutfitId() {
        if (!Array.isArray(profile.outfits) || profile.outfits.length === 0) {
            profile.defaultOutfitId = '';
            return;
        }
        if (!profile.outfits.some(o => o.id === profile.defaultOutfitId)) {
            profile.defaultOutfitId = profile.outfits[0].id;
        }
    }

    function applyOutfitSubPath(segments, value) {
        const [, targetKey, prop] = segments;
        if (!targetKey || !prop) {
            throw new Error(`Unsupported draft path "outfits.${segments.slice(1).join('.')}".`);
        }
        const index = /^\d+$/.test(targetKey)
            ? Number(targetKey)
            : profile.outfits.findIndex(o => o.id === targetKey);
        if (index < 0 || index >= profile.outfits.length) {
            throw new Error(`Outfit "${targetKey}" was not found in the draft.`);
        }
        const nextOutfits = deepClone(profile.outfits);
        const outfit = nextOutfits[index];
        if (prop === 'name') {
            outfit.name = String(value ?? '');
        } else if (prop === 'prose') {
            outfit.prose = String(value ?? '');
        } else if (prop === 'tags') {
            outfit.tags = cleanStringList(value);
        } else if (prop === 'referenceImages' || prop === 'reference_images') {
            outfit.referenceImages = cleanStringList(value);
        } else {
            throw new Error(`Unsupported outfit field "${prop}".`);
        }
        profile.outfits = nextOutfits;
        syncDefaultOutfitId();
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

            if (topField === 'outfits' && segments.length > 1) {
                applyOutfitSubPath(segments, value);
            } else {
                profile[topField] = normalizeFieldForManualEdit(topField, value);
                if (topField === 'outfits') {
                    syncDefaultOutfitId();
                }
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

            if (resolvedFields.has('outfits') && !resolvedFields.has('defaultOutfitId')) {
                const defaultManualChanged = manualRevisions.defaultOutfitId > Number(baseRevisions.defaultOutfitId || 0);
                if (!defaultManualChanged) {
                    syncDefaultOutfitId();
                }
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
                if (entry.path === 'outfits') {
                    syncDefaultOutfitId();
                }
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
    profileToSave.outfits = normalizeDraftOutfits(profileToSave.outfits).map(outfit => ({
        ...outfit,
        referenceImages: outfit.referenceImages.map(imagePath => {
            const direct = promotedMap.get(imagePath);
            if (direct) return direct;
            if (isStagedTempImagePath(imagePath)) {
                const normalized = promotedMap.get(normalizeLocalImagePath(imagePath));
                if (normalized) return normalized;
            }
            return imagePath;
        }),
    }));

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
